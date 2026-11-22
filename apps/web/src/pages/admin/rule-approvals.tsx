// Notification rule approvals (C6): someone other than the author publishes or rejects a proposed change.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ButtonRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { localDateTime } from './notification-rules';

// ---------------------------------------------------------------------------------------------------------
// C6 "publication and mandatory notification settings require business owner approval" (0133): someone other than the author
// publishes a proposed change before its date, or rejects it with a reason.
// ---------------------------------------------------------------------------------------------------------

export const APPROVE_RULES = 'notification.approve_rules.operational';

interface RuleProposal {
  id: string;
  code: string;
  revision: number;
  version: number;
  effectiveFrom: string;
  active: boolean;
  optionalEvent: boolean;
  proposalReason: string | null;
  proposedByAccountKey: string | null;
  subjectTemplate: string | null;
  bodyTemplate: string;
  currentActive: boolean | null;
  currentSubjectTemplate: string | null;
  currentBodyTemplate: string | null;
}

function RuleProposalDecision({ proposal, onDone }: { proposal: RuleProposal; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (path: 'publish' | 'reject') =>
      api(`/v1/notifications/rules/proposals/${proposal.id}/${path}`, { body: path === 'publish' ? { expectedVersion: proposal.version } : { expectedVersion: proposal.version, reason: reason.trim() } }),
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone();
    },
  });
  return (
    <ButtonRow>
      <Button type="button" disabled={decide.isPending} aria-label={`Approve ${proposal.code}`} onClick={() => decide.mutate('publish')}>
        Approve
      </Button>
      <Input
        aria-label={`Reason for rejecting ${proposal.code}`}
        placeholder="Reason to reject"
        maxLength={500}
        className="w-auto"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button type="button" variant="danger" disabled={decide.isPending || !reason.trim()} aria-label={`Reject ${proposal.code}`} onClick={() => decide.mutate('reject')}>
        Reject
      </Button>
      <ErrorNote error={decide.error} />
    </ButtonRow>
  );
}

export function NotificationRuleApprovalsPage() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const allowed = can(APPROVE_RULES);
  const key = ['notification-rule-proposals', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`] as const;
  const proposals = useQuery({ queryKey: key, enabled: allowed, queryFn: () => api<{ items: RuleProposal[] }>('/v1/notifications/rules/proposals') });
  if (!allowed) {
    return (
      <Section title="Notification rule approvals">
        <Empty>The selected role cannot approve notification rules; that needs the rule approval grant.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Notification rule approvals">
      <Hint>A change comes into force only once someone other than its author approves it, before its date. A date that has passed cannot be approved: reject it so that a new date can be proposed.</Hint>
      <ErrorNote error={proposals.error} />
      {proposals.data?.items.length === 0 && <Empty>No change is waiting for approval.</Empty>}
      {/* `tasks`: the list's marker class, which styles.css draws each proposal by, as in the decision lists. */}
      <ul className="tasks">
        {proposals.data?.items.map((p) => (
          <li key={p.id} aria-label={`Proposed change to ${p.code}`}>
            <div>
              <strong>{p.code}</strong>{' '}
              <Hint as="span">
                revision {p.revision}, from {localDateTime(p.effectiveFrom)}, by {p.proposedByAccountKey ?? 'unknown'}
              </Hint>
            </div>
            <dl className="kv">
              <div>
                <dt>Why</dt>
                <dd>{p.proposalReason ?? '—'}</dd>
              </div>
              <div>
                <dt>Message now</dt>
                <dd>{p.currentBodyTemplate ?? '—'}</dd>
              </div>
              <div>
                <dt>Proposed message</dt>
                <dd>{p.bodyTemplate}</dd>
              </div>
              <div>
                <dt>Subject now</dt>
                <dd>{p.currentSubjectTemplate ?? '—'}</dd>
              </div>
              <div>
                <dt>Proposed subject</dt>
                <dd>{p.subjectTemplate ?? '—'}</dd>
              </div>
              {p.optionalEvent && p.active !== p.currentActive ? (
                <div>
                  <dt>Sending</dt>
                  <dd>{p.active ? 'switched on' : 'switched off'}</dd>
                </div>
              ) : null}
            </dl>
            <RuleProposalDecision proposal={p} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
          </li>
        ))}
      </ul>
    </Section>
  );
}
