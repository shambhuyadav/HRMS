// The retention screen (FR-058, DF08): approved rules and holds, and a dry run only.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
        <p className="hint">{eligibility.data?.note ?? ''}</p>
        <ErrorNote error={eligibility.error} />
      </Section>

      <Section title="Retention rules">
        {rules.data?.items.length === 0 && <Empty>No rules yet.</Empty>}
        <ul className="tasks">
          {rules.data?.items.map((r) => (
            <li key={r.id}>
              <div>
                <strong>
                  {r.resource} rev {r.revision}: keep {r.retainDays} days
                </strong>{' '}
                <StateBadge state={r.state} />
              </div>
              <div className="hint">{r.basisNote}</div>
              {r.state === 'DRAFT' && approver && (
                <div className="row">
                  <button type="button" onClick={() => act.mutate({ path: `/v1/retention/rules/${r.id}/activate`, body: { expectedVersion: r.version } })}>
                    Activate
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/rules', body: { resource: 'audit_event', retainDays: Number(rule.retainDays), basisNote: rule.basisNote } });
              setRule({ retainDays: '', basisNote: '' });
            }}
          >
            <label>
              Keep audit events (days)
              <input type="number" min={1} max={36500} required value={rule.retainDays} onChange={(e) => setRule({ ...rule, retainDays: e.target.value })} />
            </label>
            <label className="wide">
              Basis (approved schedule reference)
              <input required maxLength={1000} value={rule.basisNote} onChange={(e) => setRule({ ...rule, basisNote: e.target.value })} />
            </label>
            <button type="submit">Propose rule</button>
          </form>
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
                <StateBadge state={h.state} /> <span className="hint">requested {formatDate(h.requestedAt)}</span>
              </div>
              <div className="hint">{h.reason}</div>
              {approver && h.state === 'PENDING' && (
                <div className="row">
                  <button type="button" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'APPROVE' } })}>
                    Approve
                  </button>
                  <button type="button" className="danger" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'REJECT' } })}>
                    Reject
                  </button>
                </div>
              )}
              {approver && h.state === 'ACTIVE' && (
                <div className="row">
                  <input aria-label="Release reason" placeholder="Release reason" value={releaseReason[h.id] ?? ''} onChange={(e) => setReleaseReason({ ...releaseReason, [h.id]: e.target.value })} />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!releaseReason[h.id]?.trim()}
                    onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/release`, body: { expectedVersion: h.version, reason: releaseReason[h.id] } })}
                  >
                    Release
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/holds', body: { resource: hold.resource, reason: hold.reason, ...(hold.recordKey ? { recordKey: hold.recordKey } : {}) } });
              setHold({ resource: '', recordKey: '', reason: '' });
            }}
          >
            <label>
              Record kind
              <input required pattern="[a-z][a-z0-9_]*" value={hold.resource} onChange={(e) => setHold({ ...hold, resource: e.target.value.trim().toLowerCase() })} />
            </label>
            <label>
              Record id (blank = all)
              <input value={hold.recordKey} onChange={(e) => setHold({ ...hold, recordKey: e.target.value.trim() })} />
            </label>
            <label className="wide">
              Reason
              <input required maxLength={1000} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} />
            </label>
            <button type="submit">Request hold</button>
          </form>
        )}
        <ErrorNote error={act.error ?? rules.error ?? holds.error} />
      </Section>
    </>
  );
}
