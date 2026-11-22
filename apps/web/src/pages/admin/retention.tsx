// The retention screen (FR-058, DF08): approved rules and holds, and a dry run only.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Retention (FR-058, DF08): approved rules and holds; purge is disabled, so only a dry run is shown.
// ---------------------------------------------------------------------------------------------------------

interface Rule {
  id: string;
  resource: string;
  revision: number;
  retainDays: number;
  basisNote: string;
  state: string;
  version: number;
}
interface Hold {
  id: string;
  resource: string;
  recordKey: string | null;
  reason: string;
  state: string;
  version: number;
  requestedAt: string;
}

export function RetentionPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['retention'] });
  const rules = useQuery({ queryKey: ['retention', 'rules'], queryFn: () => api<{ items: Rule[] }>('/v1/retention/rules') });
  const holds = useQuery({ queryKey: ['retention', 'holds'], queryFn: () => api<{ items: Hold[] }>('/v1/retention/holds') });
  const eligibility = useQuery({
    queryKey: ['retention', 'eligibility'],
    queryFn: () => api<{ rule: { retainDays: number } | null; cutoffDate: string | null; eligibleCount: number; heldCount: number; note: string }>('/v1/retention/eligibility?resource=audit_event'),
  });
  const [rule, setRule] = useState({ retainDays: '', basisNote: '' });
  const [hold, setHold] = useState({ resource: '', recordKey: '', reason: '' });
  const [releaseReason, setReleaseReason] = useState<Record<string, string>>({});
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: object }) => api(path, { body }), onSuccess: refresh });
  const approver = can('retention.approve.operational');
  const manager = can('retention.manage.operational');

  return (
    <>
      <Section title="Retention dry run (audit trail)">
        {eligibility.data && (
          <p>
            {eligibility.data.rule
              ? `Rule: keep ${eligibility.data.rule.retainDays} days (cutoff ${formatDate(eligibility.data.cutoffDate)}). ${eligibility.data.eligibleCount} events would be eligible; ${eligibility.data.heldCount} are preserved by holds.`
              : 'No approved retention schedule: nothing is eligible.'}
          </p>
        )}
        <Hint>{eligibility.data?.note ?? ''}</Hint>
        <ErrorNote error={eligibility.error} />
      </Section>

      <Section title="Retention rules">
        {rules.data?.items.length === 0 && <Empty>No rules yet.</Empty>}
        {/* `tasks`: the list's marker class, which styles.css draws each rule by, as in the decision lists. */}
        <ul className="tasks">
          {rules.data?.items.map((r) => (
            <li key={r.id}>
              <div>
                <strong>
                  {r.resource} rev {r.revision}: keep {r.retainDays} days
                </strong>{' '}
                <StateBadge state={r.state} />
              </div>
              <HintLine>{r.basisNote}</HintLine>
              {r.state === 'DRAFT' && approver && (
                <ButtonRow>
                  <Button type="button" onClick={() => act.mutate({ path: `/v1/retention/rules/${r.id}/activate`, body: { expectedVersion: r.version } })}>
                    Activate
                  </Button>
                </ButtonRow>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <FormGrid
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/rules', body: { resource: 'audit_event', retainDays: Number(rule.retainDays), basisNote: rule.basisNote } });
              setRule({ retainDays: '', basisNote: '' });
            }}
          >
            <FormField>
              Keep audit events (days)
              <Input type="number" min={1} max={36500} required value={rule.retainDays} onChange={(e) => setRule({ ...rule, retainDays: e.target.value })} />
            </FormField>
            <FormField className="col-span-full">
              Basis (approved schedule reference)
              <Input required maxLength={1000} value={rule.basisNote} onChange={(e) => setRule({ ...rule, basisNote: e.target.value })} />
            </FormField>
            <Button type="submit">Propose rule</Button>
          </FormGrid>
        )}
      </Section>

      <Section title="Holds">
        {holds.data?.items.length === 0 && <Empty>No holds.</Empty>}
        <ul className="tasks">
          {holds.data?.items.map((h) => (
            <li key={h.id}>
              <div>
                <strong>
                  {h.resource}
                  {h.recordKey ? ` ${h.recordKey.slice(0, 8)}` : ' (all records)'}
                </strong>{' '}
                <StateBadge state={h.state} /> <Hint as="span">requested {formatDate(h.requestedAt)}</Hint>
              </div>
              <HintLine>{h.reason}</HintLine>
              {approver && h.state === 'PENDING' && (
                <ButtonRow>
                  <Button type="button" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'APPROVE' } })}>
                    Approve
                  </Button>
                  <Button type="button" variant="danger" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'REJECT' } })}>
                    Reject
                  </Button>
                </ButtonRow>
              )}
              {approver && h.state === 'ACTIVE' && (
                <ButtonRow>
                  <Input
                    aria-label="Release reason"
                    placeholder="Release reason"
                    className="w-auto"
                    value={releaseReason[h.id] ?? ''}
                    onChange={(e) => setReleaseReason({ ...releaseReason, [h.id]: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!releaseReason[h.id]?.trim()}
                    onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/release`, body: { expectedVersion: h.version, reason: releaseReason[h.id] } })}
                  >
                    Release
                  </Button>
                </ButtonRow>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <FormGrid
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/holds', body: { resource: hold.resource, reason: hold.reason, ...(hold.recordKey ? { recordKey: hold.recordKey } : {}) } });
              setHold({ resource: '', recordKey: '', reason: '' });
            }}
          >
            <FormField>
              Record kind
              <Input required pattern="[a-z][a-z0-9_]*" value={hold.resource} onChange={(e) => setHold({ ...hold, resource: e.target.value.trim().toLowerCase() })} />
            </FormField>
            <FormField>
              Record id (blank = all)
              <Input value={hold.recordKey} onChange={(e) => setHold({ ...hold, recordKey: e.target.value.trim() })} />
            </FormField>
            <FormField className="col-span-full">
              Reason
              <Input required maxLength={1000} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} />
            </FormField>
            <Button type="submit">Request hold</Button>
          </FormGrid>
        )}
        <ErrorNote error={act.error ?? rules.error ?? holds.error} />
      </Section>
    </>
  );
}
